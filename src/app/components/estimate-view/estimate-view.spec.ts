import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EstimateView } from './estimate-view';

describe('EstimateView', () => {
  let component: EstimateView;
  let fixture: ComponentFixture<EstimateView>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EstimateView],
    }).compileComponents();

    fixture = TestBed.createComponent(EstimateView);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
