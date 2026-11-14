import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Ribbon } from './ribbon';

describe('Ribbon', () => {
  let component: Ribbon;
  let fixture: ComponentFixture<Ribbon>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Ribbon],
    }).compileComponents();

    fixture = TestBed.createComponent(Ribbon);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
