import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PropertiesDialog } from './properties-dialog';

describe('PropertiesDialog', () => {
  let component: PropertiesDialog;
  let fixture: ComponentFixture<PropertiesDialog>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PropertiesDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(PropertiesDialog);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
